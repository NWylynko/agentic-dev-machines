# LINEAR.md

keep this file up to date

How this project uses Linear through the `linear-server` MCP. For what triaging a ticket means, see [TRIAGE.md](TRIAGE.md).

## Where the tickets live

| Thing     | Value                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------- |
| Workspace | `wylynko`                                                                                                |
| Team      | `Personal`, key `TASK` (ticket IDs are `TASK-<n>`)                                                       |
| Project   | `Agentic Dev Machines`, `P-TASK-2`, https://linear.app/wylynko/project/agentic-dev-machines-87e6ba0b5006 |
| Repo      | https://github.com/NWylynko/agentic-dev-machines                                                         |

The `Personal` team holds other projects too. Always filter by `project: "P-TASK-2"` when listing, or you will pick up unrelated tickets.

## Statuses

| Status      | Meaning here                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| Backlog     | Raw reports from Nick, untriaged tickets, tickets waiting on a product decision, and `PARKED:` tickets. |
| Todo        | Triaged and ready to implement. See "Ready to work" in [TRIAGE.md](TRIAGE.md).                          |
| In Progress | An agent or Nick is implementing it now.                                                                |
| In Review   | Not used so far. Ask Nick before using it.                                                              |
| Done        | Merged to local `main` with its tests passing. Pushing is a separate step (see below).                  |
| Duplicate   | Set `duplicateOf` first, then this status.                                                              |
| Canceled    | Won't do. Leave a comment saying why.                                                                   |

Backlog holds both untriaged and triaged-but-blocked tickets. Tell them apart by the triage header (see [TRIAGE.md](TRIAGE.md)): no header and no label means untriaged.

## Labels and priority

- Labels: only `Bug`, `Feature`, `Improvement`. Exactly one per ticket. Don't create new labels.
- Priority: `1` Urgent, `2` High, `3` Medium, `4` Low. `0` (No priority) means untriaged. High is for outages and data safety. Most things are Medium or Low.

## Titles

An imperative sentence that states the product outcome, not the mechanism: "Show why adm attach can't load models instead of a blank screen when provider auth fails", not "provider-auth catalog error handling". Prefix `PARKED: ` for tickets deliberately deferred; they stay in Backlog.

## Relations

- **Bundles.** Related tickets that should ship together become sub-issues (`parentId`) of a lead ticket. Put a `**Bundle X: <theme> (DATE grooming).**` comment on the lead that gives the order and says why they belong together.
- **Duplicates.** `save_issue` with `duplicateOf`, then set status `Duplicate`. The surviving ticket absorbs anything the duplicate added.
- **Related / blocking.** Use `relatedTo`, `blocks`, `blockedBy`. A ticket blocked by unfinished work is not ready.
- Mention other tickets as `TASK-<n>`. Linear turns them into links.

## Writing to Linear through the MCP

- Send markdown with real newlines, not `\n` escapes.
- **Prefer comments over description edits** when grooming or adding findings. Comments are append-only and can't damage the original report.
- **Images in descriptions break on patch.** `get_issue` returns `<linear-image>` tags with read-time signatures that don't match what's stored. A patch-style prepend can duplicate an image as a broken second tag. When you must rewrite a description that has images, do a full `description` rewrite and put each image back as plain markdown `![title](https://uploads.linear.app/<org>/<…>/<file-uuid>)` with no `?signature=` query. Re-read the issue afterwards and check for duplicate images.
- Never drop Nick's original text. Keep it under `---` / `**Original report**` at the bottom of the description.
- Link code with GitHub permalinks at a commit that is already pushed (`git branch -r --contains <sha>`), with line ranges: `https://github.com/NWylynko/agentic-dev-machines/blob/<sha>/<path>#L10-L20`. Links to unpushed commits 404.
- No AI disclaimer line is needed on comments. The MCP posts as the `Agent` user.

## Working a ticket

1. Move it to `In Progress` when you start.
2. Implement test first, against the ticket's "Acceptance / tests first" list.
3. Cite the ticket ID in the commit body, e.g. `(TASK-92, live 2026-10-25)`.
4. Record what you learned in the project notes in [AGENTS.md](AGENTS.md), tagged with the ticket ID.
5. When it is merged to local `main` with tests passing, move it to `Done`. If you fanned tickets out to worktree subagents, the coordinator fast-forward merges each finished branch and moves its ticket.
6. **Don't push `main` without Nick saying so.** A push to `main` publishes a release (see `.github/workflows`).
7. Anything still unverified live (e.g. needs a release first) goes in a comment on the ticket under "Still to verify live".

If you find a new bug while working, file it as a new Backlog ticket in `P-TASK-2` with evidence rather than growing the current ticket's scope.
