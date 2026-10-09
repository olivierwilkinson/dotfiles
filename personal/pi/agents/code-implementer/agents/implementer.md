---
model: anthropic/claude-opus-5-5
thinking: medium
system-prompt: append
---

<!-- Env-specific overrides only. Base rules come from the bundled pi-subagents-extension
     agent (agents/code-implementer/implementer.md) and are appended. -->

## Brain / Memory Banks

Base brain rules apply (see `agents/_base.md`): brain context is read-only reference, never run brain write commands, never touch `dailyContext.md` or `sessions.log`.

- **Named-path write exception:** if the brief names an exact file path inside a named brain project, create that one file with the `write` tool — nothing else in the bank. Code changes are never brain artifacts.
- **Lineage:** if your brief provides a lineage chain, include your own hop and any children's hops in your final report.
