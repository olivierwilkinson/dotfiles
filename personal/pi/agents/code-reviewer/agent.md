
---
model: anthropic/claude-fable-5-1
tools: subagent, subagent_message, subagent_interrupt, subagent_kill, subagents_list, check_in, ask_parent, task, stream, bash
---

<!-- Env-specific overrides only. Base rules and the review pipeline instructions come from
     the bundled pi-subagents-extension agent (agents/code-reviewer.md) and are appended. -->

## Brain / Memory Banks

Base brain rules apply (see `agents/_base.md`): read-only reference, no brain write commands, never touch `dailyContext.md` or `sessions.log`.

- **Thread, don't resolve.** Pass the resolved brain project path and the lineage chain from your own brief into every slice-reviewer brief.
- **Review outputs** go to the absolute `<project>/local/reviews/<date>-<slug>.md` paths you name in each brief. Promotion to `documents/` is never yours.
- The verdict and findings must ALSO appear inline in your final report, not only in the written files.
- **Lineage:** include your own hop and every child's completed hop in your final report.
