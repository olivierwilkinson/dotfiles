# Deep project researcher

Global user-layer agent, installed through the existing
`~/.pi/agent/agents -> ~/dotfiles/personal/pi/agents` symlink.
**Pilot pending user go. Do not run research as installation verification.**

## Roles

All roles pin `fireworks-300k/fireworks:accounts/fireworks/models/deepseek-v4p1-flash-1017`
except think-leaf (`anthropic-250k-prefer-using-this-one/claude-opus-5-5`).
The coordinator dispatches only, low thinking, no lmtools or gateway tools.
Its eight scoped leaf definitions: **vault** (medium, gateway tier), **slack**
(medium, gateway tier, Slack + Delta-routed PRs), **code-sweep** (medium,
bounded local tier, scoping phase only), **scope** (high, assembler with
bounded source-validation reads), **decomposition** (high), **facet/joint** (medium; facets are
per-cell loops, joint is a single pass), **synthesis** (high), **think**
(opus-5-5, high). All are spawning=false. The five loop roles (vault, slack,
code_sweep, facet, enumerate) iterate resource-by-resource or cell-by-cell,
SELF-DRIVING: the coordinator auto-admits the next iteration whenever the
leaf returns loop_again, and the loop stops on the leaf's advance, a spend
guard, or a ledger refusal — there are NO per-iteration human gates and NO
numeric iteration caps. Human gates are phase-end only: the scope gate and
the final return, plus $100 cost bands and any think-pass scope deltas. Think leaves are
zero-retrieval reasoning passes admitted at three points: pre-mortem after
decomposition (gates research dispatch), mid-run once wave one has
settled, post-synthesis decision/platform mapping. They propose; the parent
alone admits, within quotas and approved scope. Coordinator limits: 60
lifetime leaves, 5 concurrent. Per-run ledger
role limits: 1 scope, 1 decomposition, 3 think, 2 synthesis, 1 joint; the
loop roles (vault, slack, code_sweep, facet, enumerate) are budget-bound with no
numeric lifetime cap — spend guards, $100 cost gates and the 60-spawn
harness ceiling are the stops, and the manifest's <=10 facet CELLS are
enforced by distinct cell keys, not admission count.
No additional nested agents or decision engine is
selected.

`agents/_base.md` supplies closed inline args/result schemas, evidence/source/
coverage contracts, the chronology/cutoff/unexplored-entry contracts, index
preflight, mandatory Delta cutover, visibility rules,
read-only boundaries, no-sharing (with the loop-chain, assembler,
decomposition-consumer and recordContext exceptions) and ledger participation. Each role explicitly
replaces inherited tools. The harness force-adds communication/completion and
some background tools; a tool allowlist is not a sandbox.

## Pipeline shape

```
RUN(asOf = cutoff instant, UTC, propagated to every leaf task and report)
│
├─ PHASE 1 · SCOPING — strictly ordered, each resource loops
│   1. vault loop      (vault-leaf, ≤24 pulls/iteration)
│   2. slack+PR loop   (slack-leaf, ≤24 pulls/iteration)
│   3. code-sweep loop (code-sweep-leaf, ≤24 searches/iteration;
│                       produces the verified area map + interest seeds)
│      every iteration: leaf reports NEW findings + recommendation; the
│      coordinator AUTO-ADMITS on loop_again (no human gate); stops on
│      advance / spend guard / ledger refusal; unexplored entries relayed
│      to the parent's append-only ledger
│   4. scope assembly  (scope-leaf, reads three finals + validates named sources)
│      -> scope doc from ALL THREE sources + ## Proposed lmtools interests
│      -> ## Source validation: missing/empty/template/unverified = HARD STOP
│   5. HUMAN SCOPE GATE (digest + interests; only after every source passes)
│      -> parent: cutoff worktree on a branch, interest_add, index_build,
│         index_update; replies indexReady=true/false + names
│
├─ PHASE 2 · DEEP
│   6. vault-deep loop -> 7. slack-deep loop (same iteration gates;
│      informed by the approved scope; settle before decomposition)
│   8. decomposition (reads scope + the two deep finals; embeds per-cell
│      recordContext sub-stories — dated, clarifies/extends/new;
│      mandatory prior-art cell per target zone first, hypothesis verification tasks)
│   9. premort think pass (gates research dispatch)
│  10. facet cell LOOPS ≤10 cells, ≤5 concurrent in two waves (each task carries its
│      cell's recordContext verbatim; lmtools iff indexReady — a failed
│      preflight ESCALATES, never a silent raw fallback)
│  11. midrun think pass (after wave one settles; emits enumerationManifest
│      of class findings with enumerable seams) -> wave two: remaining cells
│      + parent-admitted enumerate-leaf loops (class -> instance lists, no
│      numeric cap, loop to seam exhaustion; new-work rows require target prior
│      art + requirement anchor + cheaper-path insufficiency)
│      -> synth-1 -> (joint-1) -> synth-2
│      -> postsynth think pass (separate agenda artifact)
│
└─ RETURN: dossier + postsynth agenda + receipts + spend + the final
   unexplored-ledger state + limitations + planning cross-check gate
   PARENT-OWNED CLOSING before planning consumption (also for scope-only):
   independent run blinded to DPR artifacts -> freeze report -> adversarial
   thinker comparison -> record verdict/corrections with deliverable
```

## Source, minimal-delta and planning gates (L1–L5)

- **L1:** Scope validates every referenced requirements/source document as
  existing, populated and non-template, with evidence in a source-validation
  table. Missing/empty/template/unverified sources block scope approval; ask the
  user for the real source or access/export, never invent replacement stories.
- **L2:** Every target zone has a mandatory prior-art research cell asking for
  the minimal delta over what exists. These cells count toward the <=10 limit
  and run first; no new-work enumeration/classification without that baseline.
- **L3:** Every needs-porting/building inventory row names a requirement/story
  or source line and cites why the cheaper existing path is insufficient.
  Facets, enumerators and synthesis enforce this; unsupported rows stay gaps.
- **L4:** Decomposition assigns hypothesis-grade requirements explicit
  confirm/falsify verification tasks. Facets resolve code-answerable questions;
  synthesis carries remaining verification tasks into the downstream plan
  handoff, never as inherited build assumptions.
- **L5:** Any DPR output consumed for planning requires a parent-arranged
  independent run, blinded to DPR artifacts/conclusions (including injected
  memory context), then an adversarial thinker comparing the frozen report
  with the DPR. Record report refs, independence attestation, verdict and
  correction status beside the deliverable. PENDING or unresolved material
  exceptions prohibit planning consumption. This is separate from the existing
  postsynth agenda and cannot bypass quotas, budgets, access or human gates.

The depth audit's remaining content-depth issue is enforced in facet/synthesis:
filename/import negatives are not content-level absence proofs. Inspect relevant
implementations, translations, server-driven payloads/feed content and route
eligibility within grants, or name the limited search and access gap. A sibling's
grep does not complete an otherwise partial implementation-preflight cell.
Existing loop/budget, index-preflight, coverage and capability-gap rules already
address the audit's other protocol issues; no new retrieval grants or model
changes are introduced here.

## Unexplored ledger

The parent persists `<artifactRoot>/unexplored-ledger.md`, append-only, one
section per phase/resource. Entries are **questions plus reachability, never
conclusions**: question, whyUnexplored (budget_gate/capability_gap/
visibility_denied/consent_boundary/convergence_stopped/scope_ruling/
window_boundary), wouldAnswer (story/cell links with clarifies/extends/new),
a concrete nextProbe, and a rough cost. A continuation run consumes the
ledger as original input: every entry is a lead that must be independently
verified before it becomes a finding, and prior-run findings may be cited
only as prior-run claims, unverified in the new run. Continuation is a fresh
human-gated run (the parent's choice at the end of a run or on request) —
not something the coordinator may start on its own. Chronology is a
pipeline-wide contract: findings are dated, state claims are "as of <date>",
superseded decisions/code/project states are dated chains, never flattened.

## Approval and run continuity

Start with phase=scope, original proposal/design refs, the run's own World
worktree (caller-pre-seeded zones; the code sweep free-ranges across it and
may self-serve `git sparse-checkout add` missing zones, reported per add),
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

- Brain memory-bank context is injected into EVERY Pi session by the brain Pi
  extension, regardless of cwd (verified 2026-10-28). For blinded retro/historical
  runs, put a project `.pi/settings.json` in the run's World worktree root
  declaring the brain package with `"extensions": [], "skills": []` — the
  project entry replaces the personal package entry for every session spawned
  in that cwd, with no effect on other sessions. Template:

  ```json
  {
    "packages": [
      {
        "source": "/Users/olivier/.local/state/tec/toolchain/user_profile/share/brain/clients/pi",
        "extensions": [],
        "skills": []
      }
    ]
  }
  ```

  Do not `brain pi uninstall` for this — it blinds globally and affects the
  user's own sessions.

- Public Slack only by default, visibility verified before channel/thread read.
  Human scope consent may add named private IDs, never DMs/mpims or private sweep.
- Check lmtools interest coverage AND index status BEFORE search/history/map.
  A missing/cold/stale index is NOT a fallback trigger: the leaf stops,
  reports blocked/partial with the preflight result, and the coordinator
  escalates to the parent. Raw rg/bash reads run only under explicitly
  parent-granted rawFallbackPrefixes. Never chase main, create worktrees or
  update indexes in read-only research.
- **Historical/cutoff runs: lmtools content tools (search/history/map) are
  allowed ONLY against a parent-prepared cutoff-locked index.** The scope leaf
  proposes the interests (see `## Proposed lmtools interests` in the scope
  doc); the human confirms them at the scope gate; the parent registers,
  builds and updates the index on the cutoff worktree branch (which locks the
  index at that head and picks up any worktree commits); the coordinator
  relays `indexReady` + interest names to the facets. Without it, facets use
  bash/rg/read only.
- Three PR backends. Events/state **>=2026-10-16T00:00:00Z MUST use Delta**;
  earlier history may use Gitstream/GitHub. Split crossing intervals. Discover/
  describe actual Delta read capability; missing Delta is a gap, not fallback.
- No sibling-output sharing, with four named exceptions: a loop role's next
  iteration reads its own chain; the scope assembler reads the three phase-1
  finals; decomposition reads the vault-deep and slack-deep finals and curates
  per-cell recordContext into facet tasks (facets never read the record
  reports); synthesis reads all admitted reports and can request ONE joint
  leaf with exactly two prior results + conflicts.
- No implementation, tests/builds, estimates/sequencing, source mutations or
  outreach. Current code/intended design/historic policy/inference stay distinct.

## lmtools interest preprocessing — parent (operator) checklist

For the run's coordinator to use lmtools (any run — forward runs index at
the current head, historical/cutoff runs at the pinned cutoff head), the
PARENT does this between scope approval and the coordinator's research
dispatch. The agent never touches index lifecycle. The scope leaf proposes
GENERATE-THEN-PICK: expect no zone to ship an interests file — for each
distinct area holding a verified prefix it generates the absent
self-ignored `.lmtools/interests.toml` snapshot
(`lmtools_code_interest_generate`), reads it, and picks entries whose seeds
cover the verified prefixes; customs are proposed only for genuine coverage
holes (including generation failures, recorded verbatim) or cutoff pins.

1. **Worktree on a branch** at the cutoff commit (`git worktree add -b
<branch> <sha> <path>` — a branch, not detached, so the index update has a
   ref to pin).
2. **Review the scope doc's `## Proposed lmtools interests`** section with the
   user — catalogue picks by name, customs with repo (the run's worktree),
   area, paths/seeds, and the stories each interest serves, customs marked
   with their hole/pin rationale. The user confirms the set is right. **User
   confirmation of the interests is the explicit approval for interest
   registration and index build/update.**
3. Register: `lmtools_code_interest_add` — generated/catalogue picks under
   valid registry names (entry seeds verbatim; `:` sanitized to `-`, e.g.
   `dpr-<runid>-<entry-slug>`); customs (e.g. `dpr-<runid>-<areaslug>`) with
   `paths` or `seedSpec` from the confirmed manifest, repo = the run's
   checkout (the cutoff worktree for historical runs).
4. First build: `lmtools_code_index_build` scoped to the named interest
   (explicitly approved via step 2). Poll the returned command; queued is not
   complete.
5. After any worktree commits: `lmtools_code_update` with cwd = the worktree
   and its branch — pinned fast path, locks the index at that head and
   delta-embeds the new commits.
6. Reply to the coordinator's scope gate with `indexReady=true` + confirmed
   interest names (or `indexReady=false` -> facets fall back to bash/rg).

## Spend ledger

Python 3.9+, stdlib only, POSIX flock. Helper operations are the only narrow
local-write exception and write only `~/.pi/agent/dpr-runs/<runId>.json` through
CLI validation. Nothing writes Brain/core docs. See `agent.md` for commands.

**Spend guards (three layers, reminder-armed).** The coordinator definition
carries the global guard — a frontmatter reminder `on: waiting, when:
{spendUsd greaterThan 90}` on the merged spendUsd counter, live immediately.
The $100 session cap is a HARD boundary: at the guard the coordinator wraps
up children, settles, assembles continuation artifacts (partial report,
unexplored-ledger state, receipts, scope refs) and returns
partial_due_to_cap — running past the cap is a NEW session consuming those
artifacts, never an in-session band extension (approve-cost exists only for
an explicitly parent-granted extension). At each
phase start the coordinator arms two phase guards from the run's
`phaseBudgets` — soft at 90% (`on: spendIncreasedBy <0.9 x cap>`) and hard at
the cap — measured from arming, so no snapshot arithmetic. Soft fire: stop
admitting iterations, ask running children to wrap up; hard fire:
`subagent_interrupt` every running child of the phase, proceed to the
phase-end gate with the cap report and budget_gate unexplored entries.
Leaves checkpoint at registration, iteration end and on wake/interrupt; the
continuous watch is the reminders, the ledger stays the book of record.
The phase guards require the extension's `spendIncreasedBy` reminder support
(user's ow/spend-increased-by branch); until it is installed the phase
guards are inert and the global cap + lease exhaustion remain the stops.

The ledger atomically records scope approval, admissions/leases (loop
admissions carry their phase: scoping admissions need no approved scope
artifact, deep ones do), uniquely
registered Pi session paths, monotonically observed assistant usage.cost.total,
settlement refs and parent approval receipts. Loop roles (vault, slack,
code_sweep) have no numeric lifetime cap in the ledger — budget gates and
human iteration approvals are the stops. Each leaf registers as FIRST
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
subagent_definition({definition: "deep-project-researcher vault-leaf"})
subagent_definition({definition: "deep-project-researcher slack-leaf"})
subagent_definition({definition: "deep-project-researcher code-sweep-leaf"})
subagent_definition({definition: "deep-project-researcher facet-leaf"})
subagent_definition({definition: "deep-project-researcher synthesis-leaf"})
```

Equivalent offline check calls the exact installed extension resolver used by
that tool, parses all ten frontmatters, compiles all nine resolved args/result
schemas using its installed compiler, verifies closed nested objects, role/model/
roster/tool tiers, and checks synthetic positive/negative child args/results:

From the agent directory (the installed extension checkout is the default;
pass a checkout path as the optional first argument to override it):

```sh
node scripts/check-definitions.mjs
```

Adjust PI_PACKAGE_DIR/extension checkout if your installation moves. No config
edits needed. For full verbatim tool-equivalent
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
loop-role phase gating (scoping before scope approval, deep after) and loop
roles budget-bound without numeric caps, leaf ownership and lease exhaustion.
These do not test live gateway permissions,
Delta availability, transport timeouts or a provider pre-request dollar stop.
