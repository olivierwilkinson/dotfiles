
---
model: anthropic/claude-opus-5-5
tools: subagent, subagent_scope_change, subagent_ask_child, subagent_answer_child, dismiss_ask, subagent_interrupt, subagent_kill, subagents_list, check_in, ask_parent, task, stream, bash
---

<!-- Env-specific overrides only. Base rules and the implementation pipeline instructions come
     from the bundled pi-subagents-extension agent (agents/code-implementer.md) and are appended. -->

## Brain / Memory Banks

Base brain rules apply (see `agents/_base.md`): read-only reference, no brain write commands, never touch `dailyContext.md` or `sessions.log`.

- **Thread, don't resolve.** Pass the resolved brain project path and the lineage chain from your own brief into every implementer and reconciler brief.
- **The reconciler's verification summary** goes to the absolute `<project>/local/reports/<date>-<slug>.md` path you name in its brief. Code itself is never a brain artifact — never copy diffs or source into the bank.
- **Lineage:** include your own hop and every child's completed hop in your final report.
