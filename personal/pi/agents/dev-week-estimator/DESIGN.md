# Dev-Week Estimator — Design v2 (consumes DPR v3.5 dossiers)

Status: design; standalone agent first (`agents/dev-week-estimator/`), DPR
`workItems` extension later. v2 supersedes the v1 sketch: the pipeline no
longer performs its own code discovery — DPR v3.5's enumeration wave now
delivers task-level input directly.

## 1. Purpose and consumers

Turn a DPR dossier into dev-week estimates with honest uncertainty:

- A decision-grade estimate sheet per condition-branch (not one number).
- A task/PR plan and readable, epic-organized markdown issues-to-file register,
  with literal source evidence and reproducible estimate working per task.
- Calibration against real git throughput, per zone.

Consumers: the proposing team (band for the Vault proposal), the estimator
maintainer (backtest), DPR (does the enumeration pay for itself).

## 2. Input contract (v3.5 dossier)

From the DPR synthesis resultSchema + markdown dossier:

| Field                                                            | Use                                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| `epics[]` (id, shape, band membership, decision dependencies)    | Top-level work units; band membership conditions                  |
| `classes[]` → `instances[]` ({anchor, change, note, confidence}) | THE task-level input: each instance is a located change           |
| `classes[].noSeam`                                               | Classes with no enumerable seam — parametric sizing, never padded |
| `classes[].instances[].outOfGrant` counts                        | Explicit unenumerated remainder — uncertainty allowance           |
| decision agenda (A1–A9…)                                         | Branch points; each carries band deltas                           |
| gaps / unexplored ledger (parent-fetch-or-gap, time-gated)       | Open nodes; band-mover probes labeled as such                     |
| stories US-\*                                                    | Acceptance-shape context for task synthesis                       |

## 3. Stage 1 — Decision branch tree

Every A-item becomes a conditional node with band deltas (e.g. A1 1x vs
1.5–3x; A2 attribution yes/no). Produce estimates for each materially
different branch combination — primary tree = the A-items the dossier marks
decision-agenda-first (A1×A2 for QS). Pending probes that can move a band
boundary (QS: P1 warehouse predicate, P2 production grants) are explicit
unresolved nodes, not averaged away: the sheet shows the boundary both ways.

Rule: **no number without its condition labels** (conditions register).

## 4. Stage 2 — Task synthesis from instances

- Instance → task: an instance (file:line + what changes) is task-sized when
  its change is cohesive; adjacent instances on the same seam merge into one
  task; scattered instances on one seam stay separate tasks sharing a tag.
- Dual estimate per task: **direct** (impl + focused tests) vs **full**
  (contract changes, review cycles, freeze-window timing, docs/analytics).
- `noSeam` classes: parametric sizing from analogous enumerated classes in
  the same dossier (ratio-based range), labeled as such.
- `outOfGrant` remainders: an explicit uncertainty line ("N unenumerated
  consumers beyond grant at boundary X"), never silently dropped or guessed.

## 5. Stage 3 — PR planning

- Tasks → PRs grouped by zone/package ownership (CODEOWNERS-aware).
- Paired freeze-bound changes flagged as one land-unit (QS: E3+E5 share the
  REQUIRED_SIGNUP_VERDICT_FLAGS signup-e2e coupling — land together or not
  at all).
- Every plan includes dossier-evidenced flag-removal/cleanup PRs at the tail
  (51129 lesson: 2316915/2317049-style removal is real work that plans omit).
  Missing cleanup evidence is a scope gap, not license to invent a task.
- Stack structure where review load benefits; stack-collapse counted at
  calibration, not here.

## 6. Stage 4 — Throughput calibration (per zone)

From git history of the target zones (BigQuery unicorn table or local git):

- Filters: collapse stacked PRs to their substantive parent; exclude
  chore/revert/lockfile PRs; separate agent-authored (bot) from human.
- Human rate and agent rate are modeled as separate phases — bot PRs are not
  free (review + land latency + rework), never blended into one rate.
- First datapoints (51129 register): pre-pivot ≈2.0 human PRs/dev/wk;
  post-pivot ≈12.6 bot PRs/wk. Derive per-zone, not global.
- Convert the PR plan → dev-weeks per zone; sum with cross-zone sequencing.

## 7. Stage 5 — Risk multipliers and conditions

- **Scope-stability condition**: 52% of 51129's PRs were unpredictable by
  construction (post-pivot). Estimates carry a drift band, not a point, plus
  the explicit scope-stability assumption under which the point holds.
- **Calendar ≠ effort**: OOO/coordination slip (51129: GA slipped Jul 20 →
  Aug 26 on OOO); render effort-weeks and a calendar-week range.
- **Freeze windows**: bind affected items (QS: Nov 6 Core freeze binds
  E2–E5 Core items).
- **QA/compliance line items** explicit (QS: E10 transact-before-setup
  analysis; 52148's never-closed gap transfers directly).

## 8. Stage 6 — Backtest

- Primary comparator: the 51129 full PR register (201 merged PRs; 108
  scoreable vs DPR predictions; union of v2+v32 covered 107/108).
- Secondary: the team's own post-spike "2 weeks for 2 developers" estimate
  that ran ~3× — a calibration anchor for direct-vs-full task deltas.
- Measure: per-branch estimate error, task-granularity coverage
  (instances mapped to actual PRs), drift-band adequacy
  (did the actual timeline land inside the band?).

## 9. Output format

1. Estimate sheet per condition-branch: effort dev-weeks (direct/full) +
   calendar range, per epic and total.
2. Mandatory `<artifactRoot>/<runId>-issues.md`: issues to file, grouped
   under `## EPIC <id>: <title>`, preserving dossier epic IDs/names. Every
   issue has a stable task ID, imperative title, requirement anchor, literal
   evidence quote + source-file path and line/section locator, upstream code
   provenance (not independently verified), estimate working, condition-
   labeled branch/band membership and dependency task IDs (`none` if empty).
   Empty epics are explicit. This is a draft register, not live issue filing.
3. PR plan with paired/freeze flags and cleanup tail.
4. Calibration notes: zone rates used, filter accounting.
5. Conditions register: every number's A-item/P-item condition labels.
6. Known-unknowns register: outOfGrant remainders, noSeam classes,
   parent-fetch-or-gap items, time-gated items.

### Issues working and structured mirror

Every task's working shows the calibration zone/window and human/bot rate,
base ewk (effort dev-weeks) and equivalent dev-days, declared days/dev-week,
PR-equivalent allocation, complexity/uncertainty multipliers with reasons
(including 1x), direct/full arithmetic and results, additive overhead with
its own derivation, rounding, dependencies and conditions. Bot PRs/week are
not human PRs/dev-week; separate bot review effort and calendar factors.
Shared PR tasks partition its base (allocations sum to 1 per branch).
For example, purely illustrative: at 2 human PR-equivalents/dev-week and
5 days/dev-week, allocation 0.5 gives base 0.25 ewk = 1.25 days. Direct:
1.25 × complexity 1.2 × uncertainty 1 = 1.5 days = 0.3 ewk. Full: 1.5 ×
review 1.5 + derived overhead 0.25 days = 2.5 days = 0.5 ewk. A real row
must cite evidence for those factors and overhead, not reuse these values.

The closed task schema requires `issueTitle`, `requirementAnchor`,
`evidence[]` (quote/sourceRef/locator/upstreamAnchor), `branchBands[]`
(branchId/bandId/conditions/estimateWorking), and `dependsOn[]`. IDs match
`tasks`/`prPlan`. Scalar directDays/fullDays describe the first membership;
branch-specific working is authoritative for variants. A noSeam task
requires a quoted class/requirement and an evidenced enumerated analogue.
Unavailable evidence is a gap, never an invented quote. Missing/zero rates
leave items explicitly unpriced and excluded from sums, not free.

The register ends with per-epic and total direct/full sums for EVERY
approved branch/band, issue IDs counted once, sheet totals, separately
derived adjustments, and signed residual `sheet - issues - adjustments`.
Show rounding deltas; keep mutually exclusive variants and calendar ranges
separate. No balancing tasks, padding or silently dropped outOfGrant work.

### Materialization and validation gates

The read-only estimate leaf returns nonempty `issuesMarkdown` and
`issuesRef`. The coordinator materializes the markdown via its bash tool
before audit, alongside the sheets/structured estimate. Audit receives the
exact file refs, dossier, calibration and intake; no code retrieval. The
mandatory hygiene-and-plan lens returns exactly three `issuesChecks`:

- `evidence_quotes`: compare every quote literally at its named locator;
  check the claimed change/requirement, structured mirror and noSeam analogue.
- `estimate_arithmetic`: independently re-derive base, factors, overhead,
  allocations, unit conversions, direct/full outcomes and rounding.
- `band_reconciliation`: reconcile each epic and branch/band against sheets
  and branchTree, check IDs/membership/dependencies (including cycles),
  exclusions, allowances and residuals.

Checks have pass/fail outcomes and concrete details. Missing/unreadable
sources, missing working, unexplained residuals or absent/failed checks
prevent estimate_ready; return partial_due_to_gap with the defects. Only
the estimate role emits issues content/ref; other roles return empty strings.
Other audit lenses and non-audit roles return `issuesChecks: []`.
After admitted edits/est-2, sheets, JSON and register must agree and the
final content needs a fresh hygiene audit within the existing leaf bound;
no stale pass or unbounded repair loop. The final coordinator result carries
`issuesRef` (empty only before materialization, never a fictional path).

Offline validation: from this directory run
`node scripts/check-definitions.mjs` (optionally supply an extension checkout
path to override the installed default).
It resolves the installed chains, compiles closed schemas, checks required
issues fields and rejects malformed synthetic examples. This is structural
validation only: quote truth, arithmetic and reconciliation are checked by
the runtime hygiene lens and readiness gate, not proven by the checker.
No pilot, retrieval or live issue filing is part of installation checks.

## 10. What v3.5 closed from the v1 audit (task-level was ~60%)

| v1 gap                         | Closed by                                                              |
| ------------------------------ | ---------------------------------------------------------------------- |
| Completion-route shape unknown | v34 scope C33-F1 (1x vs 1.5–3x resolved as epic shapes)                |
| Core flag registration sizing  | C33-F5 mechanism + E5 paired-change flag                               |
| Test/analytics sizing          | E7/E8 enumerations (telemetry callsites, dashboard assembly instances) |
| Design excluded                | Standing exclusion (remains; stated as a condition)                    |
