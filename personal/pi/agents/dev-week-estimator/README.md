# Dev-week estimator

Global user-layer agent, installed through the existing
`~/.pi/agent/agents -> ~/dotfiles/personal/pi/agents` symlink.
Design contract: `DESIGN.md` (v2 — consumes DPR v3.5 dossiers).
**Pilot pending user go. Do not run an estimate as installation
verification.**

## Roles

All roles pin `fireworks-300k/fireworks:accounts/fireworks/models/deepseek-v4p1-flash-1017`
except audit-leaf (`anthropic-250k-prefer-using-this-one/claude-opus-5-5`).
The coordinator dispatches only, low thinking, no retrieval tools. Its four
scoped leaf definitions: **calibration** (medium, the ONLY retrieval tier —
bounded local git, <=60 commands, one leaf PER ZONE dispatched
concurrently, BigQuery is parent-fetch-or-gap), **estimate** (high,
zero-retrieval core assembly, single leaf for cross-branch math
consistency), **audit** (opus-5-5, high, adversarial proposals dispatched
as up to three CONCURRENT independent lenses — conditions-and-drift,
hygiene-and-plan, blindness; the coordinator alone admits, at most one
re-estimate), **backtest** (medium, zero-retrieval scoring against a
supplied comparator register). All are spawning=false, lineage-only.

**No ledger, no loops:** dispatches are bounded, including at most one
re-estimate and one final hygiene check of changed artifacts; budgets ride
spawn instructions plus the coordinator's armed spend reminder ($30 guard).
Human gates: ONE intake gate (dossier digest, zones, windows, branch set,
comparator) before expensive work, and the consumer's review of the final
estimate at the end. Coordinator limits: 12 lifetime leaves, 4 concurrent.
Parallelism lives where there is no shared state: per-zone calibration and
per-lens audit run concurrently; estimate stays single because branch math,
PR grouping and conditions registers must be one coherent pass.

`agents/_base.md` supplies the closed inline args/result schemas, the
estimate-honesty contract (condition labels on every number, instances as
the only task-level ground truth, dual estimates, noSeam parametric,
outOfGrant allowances, bot-throughput-never-free, dated regime rows),
no-sharing, and read-only boundaries.

## Pipeline shape

```
RUN(asOf, dossierRef = DPR v3.5 synthesis artifact)
│
├─ 1. intake validation (coordinator): digest check + dossier-shape check
│      (epics / classes[].instances[] / noSeam / decision agenda / gaps)
│      -> blocked_missing_input if short; never repair the dossier
├─ 2. INTAKE GATE (human): dossier digest, targetZones, calibration
│      windows, branch set (A-items + band-mover probes shown both ways),
│      comparator if any
├─ 3. calibration-leaf (one PER ZONE, concurrent; bounded local git):
│      zoneRates — human vs bot PR rates, stack-collapse + chore filters,
│      dated regime rows; coordinator merges, flags overlapping windows
├─ 4. estimate-leaf (one, zero-retrieval): branch tree, task synthesis
│      from instances, PR plan (paired/freeze/cleanup flags), risk
│      multipliers, per-branch dev-week sheets + epic-organized issues markdown
├─ 5. audit-leaf (up to three CONCURRENT lenses, opus, zero-retrieval):
│      conditions-and-drift / hygiene-and-plan / blindness; parent alone
│      admits merged amendments; at most ONE re-estimate (est-2), then
│      a final hygiene check if artifacts changed (within the leaf bound)
├─ 6. backtest-leaf (optional, only if comparator approved at intake):
│      per-branch error, task coverage, drift-band adequacy
└─ 7. final package -> artifactRoot (sheets + structured JSON + conditions
       register + known-unknowns + <runId>-issues.md); consumer review is
       the closing gate
```

## Issues-to-file deliverable and validation

Every estimate produces **`<artifactRoot>/<runId>-issues.md`**, readable
markdown grouped by existing epic IDs/names. Each task has a stable ID,
imperative issue title, requirement anchor, **verbatim evidence quote +
source-file path and line/section locator**, upstream code provenance,
condition-labeled branch/band membership and dependency IDs (or `none`).
Quotes come from named input artifacts, not unseen code. noSeam sizing
requires a quoted requirement/class and an evidenced enumerated analogue.
No unsupported cleanup/QA tasks and no live issue filing.

Every task shows its estimate working: calibration zone/window/rate,
base dev-days and ewk (effort dev-weeks), days/dev-week, PR allocation,
complexity/uncertainty multipliers **with reasons** (explicit 1x), additive
overhead derivation, direct/full arithmetic and results, rounding, and
calendar factors kept separate. Shared PR allocations sum to 1 per branch.
The register reconciles per-epic and total direct/full sums for every
approved branch/band with sheets/branchTree, explicit adjustments and the
signed residual. Unpriced work is labeled and excluded, never zero-cost.
See `DESIGN.md` for the full contract and illustrative calculation.

The estimate leaf returns required, nonempty `issuesMarkdown`/`issuesRef`;
the coordinator materializes the file before auditing and returns its path
in the final result. Tasks mirror the evidence, working, memberships and
dependencies in the closed schema. The mandatory **hygiene-and-plan** lens
checks every literal quote, independently re-derives task arithmetic and
reconciles all branch/band sums. Its three `issuesChecks` must all pass for
`estimate_ready`; missing sources/working, unpriced work or unresolved
reconciliation mean `partial_due_to_gap`. Changed final artifacts require a
fresh hygiene check, not reuse of a stale pass. Other roles emit empty
issues content/ref and non-hygiene lenses emit no issues checks.

From this directory, run the offline definitions check:

```sh
node scripts/check-definitions.mjs
```

The checker defaults to the installed extension checkout under
`~/.pi/agent/git/github.com/olivierwilkinson/pi-subagents-extension`; pass
another checkout path as an argument if needed.

This resolves real definition chains, compiles schemas and exercises valid
and invalid synthetic issues contracts, **without spawning agents or running
a pilot**. It proves structural conformance, not source truth or numerical
correctness; the runtime audit/readiness gate covers those semantics.

## Differences from deep-project-researcher

No self-driving loops, so no ledger and no per-iteration admission; no
lmtools or gateway tiers anywhere; retrieval exists only in the calibration
leaf's bounded git reads. The estimator never re-researches the dossier —
input gaps go back to the DPR parent as blocked_missing_input.
