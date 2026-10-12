---
description: The generic orchestrator with every mechanical orchestration turn decided by the jev engine instead of an LLM — spawns any roster agent (several in parallel or sequence), waits, checks in, and converges all worker reports. Same delegation base; only who decides changes.
model: decision/jev
spawning: true
base-subagent: orchestrator
tools: subagent, subagent_scope_change, subagent_answer_child, dismiss_ask, subagent_ask_child, subagent_interrupt, subagent_kill, subagents_list, subagents_roster, subagent_ask_parent, subagent_wait, task, stream, complete_task, reminder, check_in, subagent_done
reminders:
  - on: waiting
    after: 90s
    repeat: true
    cap: 2
    message: "Dwell ping ({duration} idle): if the goal calls for a mid-run status check or a worker may be stuck, check in on it now; otherwise keep waiting."
---

# Orchestrator — jev decision route

The base orchestrator's delegation rules apply unchanged; this file changes
only WHO decides. Under `model: decision/jev` every turn is a decision from
the jev engine (the stdio bridge in `decision-orchestrator/scripts/jev-bridge.mjs`,
configured in the global `_base.md`), not a model completion. The route
mechanics, contract, safety rails and audit sidecar are documented in
`decision-orchestrator/agent.md` — read that agent's doc for the details.

What the engine does, mechanically, like any orchestrator:

- Spawns workers chosen from the session's roster (`state.workers` tracks
  each: name, agent, child id, running, spawn_failed, completed, verdict,
  report). Several workers may run in parallel or sequence.
- Waits while workers run; worker events (results, answers, reminders) wake
  the loop. The 90s dwell reminder above is the mid-run steering point.
- Checks in on any running worker when one may be stuck or off-course.
- Converges every completed worker's report into one `subagent_done` and ends.

Your job in the prompt layer: keep the goal honest and specific (it is the
task text every spawned worker receives, prefixed with a worker-role
preamble), and surface the engine's `say` verbatim. Decisions cost $0.00;
the `<session>.decisions` sidecar is the audit log — cite it when reporting.
