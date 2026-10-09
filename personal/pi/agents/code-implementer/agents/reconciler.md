---
system-prompt: append
---
model: anthropic/claude-opus-5-5

<!-- Env-specific overrides only. Base rules come from the bundled pi-subagents-extension
     agent (agents/code-implementer/reconciler.md) and are appended. -->

## Brain / Memory Banks

Base brain rules apply (see `agents/_base.md`).

- **Named-path write exception:** you may write your verification summary to the exact `<project>/local/reports/<date>-<slug>.md` path named in your brief, using the `write` tool — nothing else in the bank, and no bash, git, or brain commands *against the bank*. Your integration and commit work in the code repo is unaffected.
- **Lineage:** if your brief provides a lineage chain, include your own hop in your final report.
