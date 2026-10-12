---
description: Orchestrator driven by the jev decision engine (TypeSafe System One via Shopify AI Proxy) instead of an LLM. Overrides the bundled placeholder with the shop-pi-fy jev extension wiring.
model: decision/jev
spawning: true
reminders:
  - on: waiting
    after: 90s
    repeat: true
    cap: 2
    message: "Dwell ping ({duration} idle): if the goal calls for a mid-run status check or the worker may be stuck, check in on it now; otherwise keep waiting."
tools: subagent, subagent_scope_change, subagent_answer_child, dismiss_ask, subagent_ask_child, subagent_interrupt, subagent_kill, subagents_list, stream, task, complete_task, reminder, check_in, subagent_ask_parent, subagent_wait, subagent_done
# No decisionEngines here: the jev engine is inherited from the global _base.md.
---

# Decision Orchestrator (jev via Shopify AI Proxy)

Every turn of this agent is a decision from the jev engine, not a model
completion. The stdio engine is `scripts/jev-bridge.mjs` (configured once in the
global `_base.md` `decisionEngines:` block, inherited by this agent), which:

1. Reads the turn's DecisionRequest (goal, instructions, tool allowlist, events).
2. Asks jev one question battery in a single call — `done` (noul), `next_action`
   (choice: spawn_worker / wait / report_done / check_in / other), and
   `worker_agent` (choice: worker / scout / monitor / other) — through the
   shop-pi-fy jev extension's `evaluateJev`/`resolveProxyToken`
   (`https://proxy.shopify.ai/vendors/typesafe/v1/systemone`, auth:
   `SHOPIFY_PROXY_AUTH_HEADER`/`SHOPIFY_PROXY_KEY`, then
   `PI_PROXY_AUTH_HEADER`/`PI_PROXY_API_KEY`, then the devx broker token).
3. Maps the answers to concrete tool calls: spawn workers with the goal
   (agents chosen from the request's roster; several may run in parallel or
   sequence), wait (no calls; worker events wake the loop), check in on any
   running worker, or report done via `subagent_done` converging every
   worker's report, and terminate.

## Delegation policy

- Coordinate only: the bridge spawns workers for the goal and converges
  their reports; reads, git operations and verification belong to the
  workers.
- The jev answers and full request diagnostics ride in each decision's
  `diagnostics` and the session `.decisions` audit sidecar.
- Pinning: set `JEV_MODEL` (default `jev-latest`) in the engine `env` for
  repeatable judgments.

## Files

- `scripts/jev-bridge.mjs` — the stdio bridge (imports the shop-pi-fy jev
  extension; no duplicated auth logic).
- `scripts/node_modules` — symlink to the pi-subagents-extension checkout's
  node_modules (jiti + typebox resolution for the bridge).
- The extension itself: `~/.pi/agent/git/github.com/shopify-playground/shop-pi-fy/extensions/jev/`
  (also symlinked into `~/.pi/agent/extensions/jev`).
