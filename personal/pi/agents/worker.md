---
model: openai/gpt-6.1-sol
thinking: high
tools: read, bash, write, edit, complete_task, lmtools_code_update, lmtools_code_interest_add, lmtools_code_interest_list, lmtools_code_interest_remove
system-prompt: append
---

<!-- Env-specific overrides only. Base rules (incl. complete_task tool, deny-tools, PR-state
     and search-hygiene rules) come from the bundled pi-subagents-extension agent
     (agents/worker.md) and are appended. Do not duplicate them here. -->

## Brain / Memory Banks

Exception to the base brain rules: when the parent's task explicitly assigns a documentation update (e.g. "update project docs for X"), follow the task and the bank's rules for the named project only. Such assignments are scoped to that project's files — no git commits or pushes, and no brain lifecycle/write commands.


## Installable app builds — never local

When verification needs an installable iOS or Android app build (a build to install and run for verification, tophat, repro, or UI evidence), NEVER build it locally. Use the `bitrise-builds` skill instead: trigger the requested Bitrise pipeline (platform + pipeline, optional branch) through the skill and return the build link. The skill builds origin's state of the branch only — all changes must already be pushed to origin before triggering; if unpushed work exists, stop and report that the push must happen first. Local builds are only for focused test runs, never for producing an installable app.
