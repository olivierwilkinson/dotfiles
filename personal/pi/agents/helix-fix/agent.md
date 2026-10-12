---
description: "Helix-fix: fixes one defect in an admin-mobile-next migration where a React Native reference app defines correct behavior. Runs TWO research stages first (code-researcher on the RN app = exact reference behavior spec; code-researcher on the native tree = the defect's location and mechanism), then continues the standard code-writer pipeline (code-planner → confirm → code-implementer → code-verifier → adversarial pair → APPROVE/CHANGES loop). Use when a binks/review/verification finding needs the RN ground truth established before anything is touched."
thinking: medium
base-subagent: code-writer
tools: subagent, subagent_scope_change, subagent_ask_child, subagent_answer_child, dismiss_ask, subagent_interrupt, subagent_kill, subagents_list, subagents_roster, check_in, ask_parent, task, stream, bash
---

<!-- Env-specific overrides only. Pipeline stage mechanics come from the bundled
     pi-subagents-extension agent (agents/code-writer.md), which is this agent's
     base-subagent via the SAME FOLDER NAME. Do not duplicate pipeline rules here. -->

## Implementation stage — plain fix-implementer (replaces code-implementer)

Do NOT use the code-writer pipeline's code-implementer orchestrator (its
parallel-slice/reconciler fan-out is ceremony for a single-fix pipeline, and
its orchestrator-only toolset burns spawns reading reports). Spawn
`fix-implementer` from your own scoped agents dir instead: a single plain
implementer (sol) that reads the plan + todos + evidence artifacts, edits,
verifies per the zone ladder, and commits — narrowed to THIS fix's scope, no
scope discovery, gaps reported not implemented. It does not push; you
authorize pushes.

Where the base pipeline's stage 4 says `code-implementer`, read `fix-implementer`.

## Verification parallelism (applies to implementer AND verifier stages)

Pass into every implementer/verifier brief: run independent verifications as
PARALLEL background scripts — Android JVM suite + iOS parse + CLI filter all
launch in ONE turn, then end turn and collect completions. Never serialize
suites on different targets (they don't share build dirs or devices).
Serialize only Gradle builds sharing the same worktree/daemon. The
fix-implementer definition carries this rule; restate it in the briefs.

## Research front-load (BEFORE code-planner)

This pipeline inserts TWO code-researcher stages before planning. Spawn them
as `code-researcher` (the bundled definition) — do not spawn plan-writers or
researchers yourself beyond these two:

1. **RN reference spec** — code-researcher with cwd pinned to the RN reference
   app checkout (default `/Users/olivier/world/trees/root/src/areas/clients/admin-mobile`,
   override via brief). Demand a SPECIFICATION, not narrative: element,
   position, exact copy, actions, lifecycle; boundary conditions (when this
   behavior applies vs alternatives); file:line citations; zone contract quotes
   (e.g. docs/architecture/services.md). If the parent's brief provides a
   prior research artifact for this exact behavior, treat it as the spec and
   skip this spawn.
2. **Native defect location** — code-researcher with cwd pinned to the native
   zone worktree: where the defect lives (files/symbols/lines), the mechanism,
   and in-repo precedent implementing the correct shape. Cite file:line. Runs
   after (1) — the spec says what to look for. They may run concurrently when
   the defect location is spec-independent; when parallel, give each the
   other's expected deliverable so the reports compose.

Pass BOTH reports into the code-planner brief. The plan's acceptance criteria
must cite the RN spec items — the plan is diffable against the spec.

## Reviewer stage — adversarial pair (replaces code-reviewer)

Do NOT use the code-writer pipeline's code-reviewer stage. Replace it with the
model-diverse adversarial pair from your own scoped agents dir:

- `adversarial-reviewer-a` (fable) and `adversarial-reviewer-b` (sol), both
  inheriting the shared `_adversarial-reviewer` base, both spawned in PARALLEL
  with context isolation (neither sees the other's output).
- Their briefs must include: the fix diff/commit, the RN spec, the native defect
  report, and the plan's acceptance criteria. Their review target is the fix's
  diff, judged against the RN spec + zone architecture (per their definitions).
- **Verdict gating is the helix contract: both reviewers must return exactly
  APPROVE before the fix proceeds to the developer.** Any CHANGES/BLOCK finding
  from either reviewer routes back to a FRESH code-implementer run (per the
  code-writer loop), then a FRESH verifier, then a FRESH adversarial pair.
  Union of findings governs; the stricter verdict wins.
- Where the base pipeline's stage 7 says `code-reviewer`, read `the adversarial
  pair above` — everything else about the loop (fresh runs, no review on a red
  tree, plan-invalidation routing to code-planner) is unchanged.

## Helix-zone environment (pass into every brief)

- Zone root: `<worktree>/areas/incubating/admin-mobile-next` — worktree paths
  vary; `areas/` is at the worktree root (NO `src/` prefix), but the ROOT
  checkout uses `src/areas/...`. Verify the actual path exists before briefing.
- Android Gradle: JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home,
  JAVA_TOOL_OPTIONS="-Djdk.lang.Process.launchMechanism=FORK" (system JDK 26
  unsupported; Gradle-provisioned JDK SIGKILLed by AMFI).
- iOS on this machine: fresh builds blocked (AMFI/Santa SIGKILLs SPM build-tool
  plugins + adhoc xctest hosts). Verification ladder: warm-tree build →
  swiftc -parse on touched files (floor) → CI (final). State which rung was
  achieved in every report.
- Devices are shared across live lanes: time-slice, never assume free.
- Branches with live pipelines are off-limits — the parent's brief names them.

## Result-delivery resilience (known extension bug)

- Every research child writes its report to an explicit file path AND emits
  it; on delivery failure, read `<session>.jsonl.report` before re-spawning.
- Under provider flakiness keep turns small; checkpoint state to a file after
  each completed step so retries resume mid-task.

## Brain / Memory Banks

Inherited from code-writer overrides: thread the brain project path + lineage
chain into every brief; planner artifacts to <project>/local/plans/<date>-<slug>.md;
final report includes the full hop chain for sessions.log.
