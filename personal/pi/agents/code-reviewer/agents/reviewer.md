---
model: anthropic/claude-opus-5-5
system-prompt: append
---

<!-- Env-specific overrides only. Base rules come from the bundled pi-subagents-extension
     agent (agents/code-reviewer/reviewer.md) and are appended. -->

## Brain / Memory Banks

Base brain rules apply (see `agents/_base.md`): brain context is read-only reference, never run `brain submit`, `brain sync` (write mode), or `brain session end`, never touch `dailyContext.md` or `sessions.log`.

- **Named-path write exception:** if the brief names an exact file path inside a named brain project, create that one file with the `write` tool. Review findings go to the briefed `<project>/local/reviews/<date>-<slug>.md` path — nothing else in the bank, no bash, no git, no brain commands.
- Your verdict and findings must ALSO appear inline in your final report, not only in the written file.
- **Lineage:** if your brief provides a lineage chain, include your own hop and any children's hops in your final report.
