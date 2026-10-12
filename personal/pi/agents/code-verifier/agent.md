---
model: anthropic/claude-opus-5-5
tools: subagent, subagent_scope_change, subagent_ask_child, subagent_answer_child, dismiss_ask, subagent_interrupt, subagent_kill, subagents_list, check_in, ask_parent, task, stream, bash
---

<!-- Env-specific override: model only. All rules/pipeline come from the bundled pi-subagents-extension agent. -->


## Installable app builds — never local

If verification requires an installable iOS or Android app build (install + run, tophat, repro, UI evidence), do not build locally. Use the `bitrise-builds` skill: trigger the requested Bitrise pipeline through the skill and use its build link. Preconditions: all changes must already be pushed to origin on the branch (the skill builds origin's state only); if unpushed work exists, stop and require the push first. Local builds are only for focused test runs.
