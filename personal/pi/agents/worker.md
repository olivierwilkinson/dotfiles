---
model: anthropic/claude-opus-5-5
thinking: high
system-prompt: append
---

<!-- Env-specific overrides only. Base rules (incl. complete_task tool, deny-tools, PR-state
     and search-hygiene rules) come from the bundled pi-subagents-extension agent
     (agents/worker.md) and are appended. Do not duplicate them here. -->

## Brain / Memory Banks

If memory-bank/brain context is injected into this session, treat it as read-only reference. Do not update `dailyContext.md`, bank files, or project docs; never run `brain submit`, `brain sync` (write mode), or `brain session end`. Report outcomes to the parent instead — the parent decides whether project docs need updating.

Exception: when the parent's task explicitly assigns a documentation update (e.g. "update project docs for X"), follow the task and the bank's rules for the named project only. Such assignments are scoped to that project's files — no git commits or pushes, and no brain lifecycle/write commands.

Named-path write exception: when the brief names an exact file path inside a named brain project, create that one file with the `write` tool. Artifact routing applies — plans go to `<project>/local/plans/<date>-<slug>.md`, reports to `<project>/local/reports/<date>-<slug>.md`. Never promote anything to `documents/`.

Lineage: if your brief provides a lineage chain, include your own hop and any children's hops in your final report.


## Installable app builds — never local

When verification needs an installable iOS or Android app build (a build to install and run for verification, tophat, repro, or UI evidence), NEVER build it locally. Use the `bitrise-builds` skill instead: trigger the requested Bitrise pipeline (platform + pipeline, optional branch) through the skill and return the build link. The skill builds origin's state of the branch only — all changes must already be pushed to origin before triggering; if unpushed work exists, stop and report that the push must happen first. Local builds are only for focused test runs, never for producing an installable app.
