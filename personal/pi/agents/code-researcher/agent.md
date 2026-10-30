---
model: fireworks-300k/fireworks:accounts/fireworks/models/deepseek-v4p1-flash-1017
base-subagent: orchestrator
tools: subagent, subagent_scope_change, subagent_ask_child, subagent_answer_child, dismiss_ask, subagent_interrupt, subagent_kill, subagents_list, subagent_ask_parent, task, stream, bash
---

<!-- Env-specific override: model only. All rules/pipeline come from the bundled pi-subagents-extension agent. -->
