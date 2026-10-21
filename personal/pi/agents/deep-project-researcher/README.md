# Deep project researcher

Global user-layer agent, installed through the existing
`~/.pi/agent/agents -> ~/dotfiles/personal/pi/agents` symlink.
**Pilot pending user go. Do not run research as installation verification.**

## Roles

All roles pin `fireworks-300k/fireworks:accounts/fireworks/models/glm-5p3-flash`.
The coordinator dispatches only, low thinking, no lmtools or gateway tools.
Its five scoped leaf definitions are scope (medium), decomposition (high),
context (medium), facet/joint (medium), synthesis (high). All are spawning=false.
Coordinator limits: 16 lifetime leaves, 3 concurrent. Per-run ledger role limits:
1 scope, 1 decomposition, 1 context, 10 independent cells, 2 synthesis, 1 joint.
No additional nested agents or decision engine is selected.

`agents/_base.md` supplies closed inline args/result schemas, evidence/source/
coverage contracts, index preflight, mandatory Delta cutover, visibility rules,
read-only boundaries, no-sharing and ledger participation. Each role explicitly
replaces inherited tools. The harness force-adds communication/completion and
some background tools; a tool allowlist is not a sandbox.

## Approval and run continuity

Start with phase=scope, original proposal/design refs, actual World cwds,
fixed UTC asOf, runId, caller-approved artifactRoot, publicOnly=true,
privateChannelIds=[], rawFallbackPrefixes=[]. See `agent.md` argsSchema for the
complete closed input. Parent-provided source grants must authorize reads, not
writing Brain files. The parent persists the scope and final artifacts.

The scope report is SHA-256 bound in the ledger. The coordinator MUST
subagent_ask_parent + subagent_wait for explicit HUMAN approval of that digest,
including any proposed named private channels/raw prefixes. Automatic continue
is not consent. No deep spawn before the receipt. Missing supplied-node UI
access needs exports/screenshots; no alternate/newer design search.

Scope-only can finish at scope_approved. Resume the **same coordinator session**
with the parent tool:

```text
subagent_resume({sessionPath: <original coordinator JSONL>, message:
  "phase=deep; scopeRef=<approved artifact>; scopeDigest=<sha256>; humanApprovalRef=<human receipt>; continue approved research"})
```

This message changes phase, not source/access grants or quotas. A fresh session
cannot adopt/reset a ledger. Changed scope needs new digest/consent; artifacts
are immutable between approvals. A scope revision beyond the single scope-leaf
admission must be supplied by the parent (or a separately approved future run),
never invented by the dispatcher.

## Research invariants

- Public Slack only by default, visibility verified before channel/thread read.
  Human scope consent may add named private IDs, never DMs/mpims or private sweep.
- Check lmtools interest coverage AND index status BEFORE search/history/map.
  Missing/cold/stale index -> skip or parent gate, never silent build. Never
  chase main, create worktrees or update indexes in read-only research.
- Three PR backends. Events/state **>=2026-10-16T00:00:00Z MUST use Delta**;
  earlier history may use Gitstream/GitHub. Split crossing intervals. Discover/
  describe actual Delta read capability; missing Delta is a gap, not fallback.
- No sibling-output sharing. Context output goes only to synthesis. Synthesis
  reasons about whether related results change each other's conclusions and
  can request ONE joint leaf with exactly two prior results + conflicts.
- No implementation, tests/builds, estimates/sequencing, source mutations or
  outreach. Current code/intended design/historic policy/inference stay distinct.

## Spend ledger

Python 3.9+, stdlib only, POSIX flock. Helper operations are the only narrow
local-write exception and write only `~/.pi/agent/dpr-runs/<runId>.json` through
CLI validation. Nothing writes Brain/core docs. See `agent.md` for commands.

The ledger atomically records scope approval, admissions/leases, uniquely
registered Pi session paths, monotonically observed assistant usage.cost.total,
settlement refs and parent approval receipts. Each leaf registers as FIRST
command and checkpoints before every retrieval; coordinator checkpoints before
every spawn/on wake. No unregistered-child wave. Costs include coordinator,
scope, decomposition, context, facets, joint and synthesis, including failed/
finished sessions. Do not double count subtree rollups. Unknown/unpriced/corrupt/
partial/decreasing telemetry fails closed. Per-file 32MiB, aggregate64MiB read
ceilings also fail closed rather than omit old costs.

At observed ~$100: pause new admissions/spawns, ask parent for the next $100 band,
then wait. Again at $200, $300, etc. Leases reserve headroom; if a sensible lease
will not fit, reduce it or explicitly request an early gate. Every approval
advances exactly ONE checkpoint, no unlimited authorization. Denial yields a
partial report/continuation manifest, not a new paid synthesis.

**Limits:** this is a cooperative admission/checkpoint implementation, not a
provider request/spawn/tool interceptor. Already in-flight calls, child turns,
compaction/report formatting and telemetry lag can overshoot. Human approval
refs are audit receipts, not authenticated consent. Shell/gateway restrictions,
Delta routing, visibility and retrieval pull/byte guidance remain instructions,
not OS/network sandboxes. Exact pre-request dollar enforcement needs a separately
authorized harness extension, which this implementation does not install.

## Offline validation, no pilot or agent spawns

Installed tool checks (root may run these in Pi):

```text
subagent_definition({definition: "deep-project-researcher"})
subagent_definition({definition: "deep-project-researcher scope-leaf"})
subagent_definition({definition: "deep-project-researcher decomposition-leaf"})
subagent_definition({definition: "deep-project-researcher context-leaf"})
subagent_definition({definition: "deep-project-researcher facet-leaf"})
subagent_definition({definition: "deep-project-researcher synthesis-leaf"})
```

Equivalent offline check calls the exact installed extension resolver used by
that tool, parses all seven frontmatters, compiles all six resolved args/result
schemas using its installed compiler, verifies closed nested objects, role/model/
roster/tool tiers, and checks synthetic positive/negative child args/results:

```sh
PI_PACKAGE_DIR="$HOME/.pi/pkg/pi-1.3.0" node \
  "$HOME/dotfiles/personal/pi/agents/deep-project-researcher/scripts/check-definitions.mjs" \
  "$HOME/.pi/agent/git/github.com/olivierwilkinson/pi-subagents-extension"
```

Adjust PI_PACKAGE_DIR/extension checkout if your installation moves. This session
inherited stale pi-1.2.0; the explicit installed pi-1.3.0 avoids an ENOENT during
standalone resolution. No config edits needed. For full verbatim tool-equivalent
output add DPR_FULL_RESOLUTION=1. Offline checker requires Node with TypeScript
strip support and the installed extension dependencies; it never launches Pi
research sessions or calls source APIs.

Synthetic ledger tests use temporary fake JSONL sessions, no real run ledger:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s "$HOME/dotfiles/personal/pi/agents/deep-project-researcher/scripts" \
  -p 'test_ledger.py' -v
```

Checks include $100/$200 gates/overshoot, approval step evidence, atomic parallel
admission and reservations, digest/stale approval, deep/scope invalidation,
unknown/missing/partial/unpriced telemetry, unique session registration,
settlement and same-session resume without quota reset, role/concurrency caps,
leaf ownership and lease exhaustion. These do not test live gateway permissions,
Delta availability, transport timeouts or a provider pre-request dollar stop.
