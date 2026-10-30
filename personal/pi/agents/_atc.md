---
description: Shared ATC family base — the read-only invariant folded under every ATC agent (atc-monitor, its checkers, atc-scribe, atc-handoff). Not spawnable; linked via base-subagent.
spawning: false
---

# ATC family base — READ-ONLY INVARIANT

No agent in this system ever writes to an external system. No Slack posts or replies, no
issue filing or commenting, no label/badge application, no Vault acknowledge/assign, no
SEV declaration or incident-bot invocation, no rollout-pause requests, no PagerDuty
actions. All gateway and `gh` usage is read/query-only. The ONLY writes anywhere are
local files under `~/.pi/agent/atc/shopify-mobile/` (state, reports, drafts, incidents).
Everything actionable is surfaced as a user task at top level; the human performs the
action manually.
