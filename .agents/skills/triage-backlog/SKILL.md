---
name: triage-backlog
description: Triage or groom this project's Linear backlog (team TASK, project P-TASK-2) — turn Nick's raw Backlog notes into evidence-backed, test-first tickets and decide what is ready for Todo. Use when asked to triage, groom, or review the backlog or a TASK-<n> ticket. Overrides the generic `triage` skill in this repo.
---

# Triage the backlog

keep this file up to date

What triaging a backlog ticket means in this project, the steps, and when a ticket counts as triaged and as ready to work on. Read [LINEAR.md](../../../LINEAR.md) first for Linear mechanics (IDs, statuses, labels, MCP gotchas).

This replaces the generic `triage` skill's GitHub label states. Its roles map onto Linear like this:

| Generic role      | Here                                                |
| ----------------- | --------------------------------------------------- |
| `needs-triage`    | Backlog, no label, priority `0`, no triage header   |
| `needs-info`      | Backlog with a triage header listing open decisions |
| `ready-for-agent` | Todo                                                |
| `ready-for-human` | Todo, with the header saying what needs Nick        |
| `wontfix`         | Canceled (with a comment), Duplicate, or `PARKED:`  |

## The goal

Nick files raw notes into Backlog: a one-line title, maybe a screenshot. Triage turns each into a ticket an agent can pick up cold and implement test first, with no need to ask Nick anything. Every claim is backed by evidence, and every decision left for Nick is framed by its effect on the product, not as a list of technical options.

## Finding the untriaged queue

`list_issues` with `project: "P-TASK-2"`, `state: "Backlog"`. A ticket is untriaged if it has no label, priority `0`, and no `**Triage —` header. Skip `PARKED:` tickets unless Nick asks about them.

## Steps

1. **Read everything.** Description, images (`extract_images`), comments, relations. Read prior triage notes so you don't redo settled work.
2. **Check for overlap.** Search the project for the same problem by concept, not wording (include Done and Canceled). Check [AGENTS.md](../../../AGENTS.md) project notes and the code. If it already exists, say where. If it duplicates a ticket, mark it Duplicate. If it fits an existing bundle, attach it there.
3. **Reproduce.** Prove the problem is real before writing it up.
   - Live, read-only, against the homelab cluster where possible (`KUBECONFIG=~/.cluster.yaml`, run a freshly built `adm` with temporary `XDG_*` dirs). Creating and destroying throwaway test workspaces is fine. Don't touch workspaces Nick is using, and don't spend his credentials (e.g. refresh tokens).
   - Otherwise reproduce in a test or locally.
   - If you could only read the code, say so plainly in the ticket.
4. **Find the cause.** Trace it to the code, with permalinks at a pushed commit. If the cause is still unknown, write an **Unknown** section saying what's missing and why you stopped. The ticket then stays in Backlog.
5. **Decide the shape of the fix.** Describe the behaviour wanted, not file-by-file edits. List what's out of scope if there's an obvious adjacent temptation.
6. **Write acceptance as tests.** "Acceptance / tests first": end-to-end checks that get as close to real use as possible (real `adm` binary, real lifecycle service, PTY for the terminal). Each one must fail today and pass after the fix.
7. **Surface product decisions.** Anything only Nick can decide goes under **Product decisions (open)**, each with options and what each means for the user. Lead with the option that gives the better experience and state its build cost.
8. **Classify.** Imperative title, one label, a priority (see [LINEAR.md](../../../LINEAR.md)).
9. **Write it into the ticket** (format below) and set the status.
10. **Report back** to Nick: what moved to Todo, what stayed in Backlog and the decisions blocking each, what you couldn't reproduce.

## Ticket format

Prepend this to the description. Keep the original report below it.

```markdown
**Triage — 2026-10-30 · Medium · ready**

**Impact.** What the user sees and who hits it.

**Evidence (live 2026-10-30, <where>).** Commands run and their output. Say "from reading code only" if nothing was reproduced.

**Unknown.** (only if something isn't known) What is missing and why.

**Code** (`<short sha>`). Permalinks to the code involved, one line each on what it does wrong.

**Fix.** The behaviour wanted, as numbered points.

**Product decisions (open).** (only if any) Each with options and their product effect.

**Acceptance / tests first.**

- e2e test that fails today and passes after.
- ...

Related: TASK-n (why), TASK-m (why).

---

**Original report**

<Nick's original text and images, untouched>
```

The readiness word in the header is one of `ready`, `needs decision`, `needs info`, or `parked`. Only `ready` tickets go to Todo.

## Triaged

A ticket is **triaged** when all of these hold:

- Title is an imperative product outcome.
- Exactly one label and a priority other than `0`.
- The triage header is in the description, with the original report kept below it.
- The claim was verified, or the ticket says it is from reading code only.
- It is in its final triage state: Todo, Backlog with open decisions listed, `PARKED:`, Duplicate, or Canceled with a reason.

Triaged does not mean ready. A triaged ticket can sit in Backlog waiting on Nick.

## Ready to work

A ticket moves Backlog → **Todo** only when the work needed is 100% understood, so an agent could start it now without asking anything. Anything less stays in Backlog:

- No open product decisions.
- No Unknown section. The cause is found and the fix is decided.
- Acceptance / tests first is concrete enough to write the failing tests straight away.
- Not blocked by unfinished work (or `blockedBy` is set and the blocker is also in Todo, earlier in the bundle order).
- If it's in a bundle, the lead's bundle comment gives its place in the order.

## Grooming the existing backlog

Grooming revisits tickets that are already triaged: re-prioritise, bundle, find duplicates, mark `PARKED:`. Use comments for this, not description edits. Only outage and data-safety work stays High.
