---
description: The brain-update orchestrator with its mechanical routing turns decided by the jev engine — same one-pass pipeline contract (projects, lineage, parentSummary args), same sub-agents (brain-drafter, brain-update-reconciler); the engine spawns, waits and converges instead of an LLM.
model: fireworks-300k/fireworks:accounts/fireworks/models/glm-5p3-flash
spawning: own
base-subagent: brain-orchestrator
tools: subagent, subagent_scope_change, subagent_answer_child, dismiss_ask, subagent_ask_child, subagent_interrupt, subagent_kill, subagents_list, subagents_roster, subagent_ask_parent, subagent_answer_parent, subagent_wait, task, stream, complete_task, reminder, check_in, subagent_done, bash, lmtools_code_update, lmtools_code_interest_add, lmtools_code_interest_list, lmtools_code_interest_generate
reminders:
  - on: waiting
    after: 90s
    repeat: true
    cap: 2
    message: "Dwell ping ({duration} idle): if a drafter may be stuck, check in on it now; otherwise keep waiting."
---

# Brain Update Orchestrator — jev decision route

The brain-orchestrator base applies unchanged: the args contract
(`projects`, `lineage`, `parentSummary`), one pass per run, the
brain-drafter / brain-update-reconciler split, and the mechanical
scope (worktrees, routing, integration — never content). This file
changes only WHO decides. Under `model: decision/jev` every turn is a
decision from the jev engine (the stdio bridge in
`decision-orchestrator/scripts/jev-bridge.mjs`, configured in the
global `_base.md`). Route mechanics, contract, safety rails and the
audit sidecar are documented in `decision-orchestrator/agent.md`.

Engine specifics for this pipeline:

- The structured spawn args arrive as `state.spawn_args` (the
  `<session>.args.json` sidecar) — the engine reads `projects` and
  `lineage` from there, so it can size the delegation without the
  parent re-explaining.
- The roster in a `spawning: own` session is exactly this agent's
  sub-agents: the engine picks `brain-drafter` for drafting work and
  `brain-update-reconciler` for rebase/integration work.
- The engine may run several drafters in parallel and converge all of
  their reports into one `subagent_done`; serial integration stays the
  reconciler's own discipline, as in the base.

Decisions cost $0.00; the `<session>.decisions` sidecar is the audit
log — cite it when reporting.
